import { useTranslations } from "next-intl";

export function Page() {
  const t = useTranslations("home");
  return (
    <h1>
      {t("title")} {t("missing")}
    </h1>
  );
}
