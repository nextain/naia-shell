/**
 * naia.land 의 로케일 접두사 페이지 하나를 연다.
 *
 * 주소를 손으로 이어 붙이면 로케일 접두사를 빠뜨려 리다이렉트에 걸린다. 그 한 가지를
 * 막는 것이 이 도구의 전부다 — 열고, 실제로 도착한 주소와 제목을 돌려준다.
 */
const DEFAULT_ORIGIN = "https://www.naia.land";
const LOCALES = new Set([
  "en", "ko", "ja", "zh", "fr", "de", "ru",
  "es", "ar", "hi", "bn", "pt", "id", "vi",
]);

export async function openPublicPage(ctx, args = {}) {
  const locale = typeof args.locale === "string" && args.locale ? args.locale : "ko";
  if (!LOCALES.has(locale)) {
    throw new Error(`naia.land 에 없는 로케일이다: ${locale}`);
  }
  const path = typeof args.path === "string" ? args.path.replace(/^\/+/, "") : "";
  const origin = typeof args.origin === "string" && args.origin ? args.origin : DEFAULT_ORIGIN;
  const url = path ? `${origin}/${locale}/${path}` : `${origin}/${locale}`;

  await ctx.browser.openOrReuseTab(url, { wait: true });
  await ctx.page.waitForLoadState("load");
  const info = await ctx.page.info();
  return { url: info.url, title: info.title };
}
