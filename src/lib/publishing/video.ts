import "server-only";
import { MetaApiError } from "@/lib/meta/errors";
import {
  checkFacebookVideo,
  checkInstagramContainer,
  createInstagramVideoContainer,
  facebookVideoResult,
  finishFacebookVideoUpload,
  publishInstagramContainer,
  startFacebookVideoUpload,
  uploadFacebookVideoBytes,
  type PublishResult,
  type PublishVideo,
  type VideoProgress,
} from "@/lib/meta/publish";

// Un video no se publica de una sola vez: la red social tarda minutos en procesarlo y el proceso en segundo plano
// atiende los destinos uno tras otro, asi que esperar ahi dentro retrasaria todo lo demas (y pasados 10 minutos
// reservado se daria por colgado). Se hace por fases, guardando el id que da la red (PostTarget.remoteId):
//
//   Instagram:  1 crear el contenedor (Meta baja el video de nuestra URL) -> [esperar] -> 2 publicarlo
//   Facebook:   1 abrir la subida, subir los bytes y finalizar (pide publicar) -> [esperar] -> 2 confirmar que ya salio
//
// Cada vuelta del proceso llama a `advanceVideoPublication`: sin remoteId hace la fase 1; con remoteId solo consulta
// (barato) y, cuando toca, hace el paso final. Lo irreversible (publicar / finalizar) nunca se repite solo si su
// respuesta no fue clara: eso lo decide el codigo de cada paso en lib/meta/publish.ts.

/** Cada cuanto se vuelve a consultar un video que la red esta procesando. */
export const VIDEO_POLL_SECONDS = 30;
/** Pasado este tiempo esperando, se da por fallido y se pide revisar en la red social. */
export const VIDEO_MAX_PROCESSING_MS = 45 * 60_000;

export type VideoStep =
  | { kind: "waiting"; remoteId: string; delaySeconds: number }
  | { kind: "published"; result: PublishResult }
  | { kind: "failed"; message: string; retryable: boolean };

export type AdvanceInput = {
  instagram: boolean;
  /** Historia con video (si no, un Reel). */
  story: boolean;
  account: { externalId: string; token: string };
  text: string;
  linkUrl: string | null;
  video: PublishVideo;
  /** Lo que guardo la fase 1; null si todavia no se hizo. */
  remoteId: string | null;
  remoteStartedAt: Date | null;
  now: Date;
};

/** Una consulta de estado que falla por algo pasajero no es un fallo del video: se vuelve a consultar en la vuelta siguiente. */
async function pollSafely(poll: () => Promise<VideoProgress>): Promise<VideoProgress | { state: "transient" }> {
  try {
    return await poll();
  } catch (e) {
    if (e instanceof MetaApiError && (e.network || e.status >= 500 || e.isRateLimit || e.code === 1 || e.code === 2)) return { state: "transient" };
    throw e;
  }
}

/** Sigue esperando, salvo que ya lleve demasiado. */
function keepWaiting(input: AdvanceInput, remoteId: string): VideoStep {
  const started = input.remoteStartedAt?.getTime() ?? input.now.getTime();
  if (input.now.getTime() - started > VIDEO_MAX_PROCESSING_MS) {
    const where = input.instagram ? "Instagram" : "Facebook";
    return {
      kind: "failed",
      message: `${where} lleva más de ${Math.round(VIDEO_MAX_PROCESSING_MS / 60_000)} minutos procesando el video. Revisa en ${where} si ya salió antes de volver a intentarlo, para no duplicarlo.`,
      retryable: false,
    };
  }
  return { kind: "waiting", remoteId, delaySeconds: VIDEO_POLL_SECONDS };
}

/**
 * Da el siguiente paso de la publicacion de un video en un destino. Los errores de la fase 1 se lanzan (MetaApiError o
 * PublishError) para que quien llama los clasifique y decida reintentar; lo demas se devuelve como un `VideoStep`.
 */
export async function advanceVideoPublication(input: AdvanceInput): Promise<VideoStep> {
  const { account, video } = input;

  if (input.instagram) {
    if (!input.remoteId) {
      const id = await createInstagramVideoContainer(account, video, { story: input.story, caption: input.text });
      return { kind: "waiting", remoteId: id, delaySeconds: VIDEO_POLL_SECONDS };
    }
    const progress = await pollSafely(() => checkInstagramContainer(account, input.remoteId as string));
    if (progress.state === "failed") return { kind: "failed", message: progress.message, retryable: false };
    if (progress.state === "ready") return { kind: "published", result: await publishInstagramContainer(account, input.remoteId) };
    return keepWaiting(input, input.remoteId);
  }

  // Facebook: el id queda como "video" o "video|publicacion" (una historia devuelve ademas el id de su publicacion).
  if (!input.remoteId) {
    const { videoId, uploadUrl } = await startFacebookVideoUpload(account, input.story);
    await uploadFacebookVideoBytes(uploadUrl, account.token, video);
    // Facebook no deja usar el texto ni el enlace como campos aparte en un Reel: el enlace va dentro de la descripcion.
    const description = input.linkUrl ? `${input.text}\n\n${input.linkUrl}` : input.text;
    const { postId } = await finishFacebookVideoUpload(account, videoId, { story: input.story, description });
    return { kind: "waiting", remoteId: postId ? `${videoId}|${postId}` : videoId, delaySeconds: VIDEO_POLL_SECONDS };
  }
  const [videoId, postId] = input.remoteId.split("|");
  const progress = await pollSafely(() => checkFacebookVideo(account, videoId));
  if (progress.state === "failed") return { kind: "failed", message: progress.message, retryable: false };
  if (progress.state === "ready") return { kind: "published", result: await facebookVideoResult(account, videoId, postId ?? null, input.story) };
  return keepWaiting(input, input.remoteId);
}
