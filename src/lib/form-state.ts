/** Estado que devuelven las Server Actions a los formularios (useActionState). */
export type FormState =
  | {
      error?: string;
      success?: string;
      fieldErrors?: Record<string, string[] | undefined>;
      /**
       * Valores que la persona habia escrito. React 19 vacia el formulario tras cada
       * envio (incluso con errores), asi que los devolvemos para repintarlos.
       * Nunca incluir contraseñas.
       */
      values?: Record<string, string>;
      /** Link de invitacion recien creado (se muestra una sola vez). */
      inviteLink?: string;
    }
  | undefined;

/** Copia los campos de texto indicados del formulario, para devolverlos en `values`. */
export function formValues(formData: FormData, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((k) => [k, String(formData.get(k) ?? "")]));
}
