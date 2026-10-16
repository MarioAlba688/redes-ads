"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as z from "zod";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { brandSchema } from "@/lib/brands";
import { db } from "@/lib/db";
import { formValues, type FormState } from "@/lib/form-state";

const FIELDS = ["name", "description", "audience", "tone", "products", "avoid", "hashtags", "callToAction", "language", "timezone"];

/** Crea o actualiza una marca y las cuentas que le pertenecen. */
export async function saveBrand(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("brands.manage");
  if (!auth.ok) return { error: auth.error };

  const id = String(formData.get("id") ?? "").trim() || null;
  const accountIds = [...new Set(formData.getAll("accountId").map(String))];
  // Se devuelven tambien las cuentas marcadas: React vacia el formulario tras cada envio.
  const values = { ...formValues(formData, FIELDS), accountIds: accountIds.join(",") };
  const parsed = brandSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };

  const accounts = accountIds.length
    ? await db.socialAccount.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, name: true, brandId: true, status: true },
      })
    : [];
  if (accounts.length !== accountIds.length) return { error: "Alguna de las cuentas elegidas ya no existe.", values };
  const taken = accounts.find((a) => a.brandId && a.brandId !== id);
  if (taken) return { error: `«${taken.name}» ya pertenece a otra marca. Quítala de allí primero.`, values };

  if (id && !(await db.brand.findUnique({ where: { id }, select: { id: true } }))) {
    return { error: "Esa marca ya no existe.", values };
  }

  const brand = await db.$transaction(
    async (tx) => {
      const saved = id ? await tx.brand.update({ where: { id }, data: parsed.data }) : await tx.brand.create({ data: parsed.data });
      // Las cuentas que ya no estan marcadas dejan de ser de esta marca; las marcadas pasan a serlo.
      await tx.socialAccount.updateMany({ where: { brandId: saved.id, id: { notIn: accountIds } }, data: { brandId: null } });
      if (accountIds.length > 0) {
        await tx.socialAccount.updateMany({ where: { id: { in: accountIds } }, data: { brandId: saved.id } });
      }
      return saved;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );

  await audit(id ? "brand.updated" : "brand.created", {
    userId: auth.user.id,
    target: brand.name,
    detail: { accounts: accountIds.length },
  });
  revalidatePath("/marcas");
  revalidatePath("/cuentas");
  if (!id) redirect(`/marcas/${brand.id}?creada=1`);
  // Se devuelven los valores: React vacia el formulario tras el envio y asi muestra lo recien guardado.
  return { success: "Marca guardada.", values };
}

/** Borra una marca. No se puede si ya tiene publicaciones (se perderia el historial). */
export async function deleteBrand(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("brands.manage");
  if (!auth.ok) return { error: auth.error };

  const id = z.string().min(1).safeParse(formData.get("id"));
  if (!id.success) return { error: "Datos no válidos." };

  const brand = await db.brand.findUnique({
    where: { id: id.data },
    select: { name: true, _count: { select: { posts: true } } },
  });
  if (!brand) return { error: "Esa marca ya no existe." };
  if (brand._count.posts > 0) {
    return { error: `«${brand.name}» tiene ${brand._count.posts} publicación(es). Bórralas antes de eliminar la marca.` };
  }

  await db.brand.delete({ where: { id: id.data } }); // sus cuentas quedan sin marca (ON DELETE SET NULL)
  await audit("brand.deleted", { userId: auth.user.id, target: brand.name });
  revalidatePath("/marcas");
  revalidatePath("/cuentas");
  redirect("/marcas");
}
