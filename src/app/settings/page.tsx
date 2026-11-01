import { redirect } from "next/navigation";

/** /settings always resolves to the Account Settings page. */
export default function SettingsIndexPage() {
  redirect("/settings/account");
}
