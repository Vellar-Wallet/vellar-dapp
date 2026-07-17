import { redirect } from "next/navigation";

// /docs → the first page. The sidebar lists everything from there.
export default function DocsIndex() {
  redirect("/docs/overview");
}
