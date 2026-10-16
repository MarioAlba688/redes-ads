import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { loadAccountOptions } from "../account-options";
import { BrandForm } from "../brand-form";

export const metadata: Metadata = { title: "Nueva marca" };

export default async function NewBrandPage() {
  await requireUser("brands.manage");
  const accounts = await loadAccountOptions();

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/marcas" className="text-muted hover:text-foreground">
          ← Marcas
        </Link>
      </p>
      <PageHeader title="Nueva marca" />
      <BrandForm accounts={accounts} selectedIds={[]} />
    </>
  );
}
