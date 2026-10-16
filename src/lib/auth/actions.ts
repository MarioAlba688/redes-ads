"use server";

import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { destroyCurrentSession, getSessionUser } from "@/lib/auth/session";

export async function logout() {
  const user = await getSessionUser();
  await destroyCurrentSession();
  if (user) await audit("auth.logout", { userId: user.id });
  redirect("/login");
}
