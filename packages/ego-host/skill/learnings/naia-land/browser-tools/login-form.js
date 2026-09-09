async function (args) {
  const form = document.querySelector("main form");
  if (!form) return { providers: [], submitCount: 0, needsHuman: false };
  const buttons = Array.from(document.querySelectorAll("main form button[type=\"submit\"]"));
  return {
    providers: buttons.map((el) => (el.innerText || "").trim()).filter(Boolean),
    submitCount: buttons.length,
    // 입력란이 없다 = 외부 제공자로 나간다 = 사람이 필요하다.
    needsHuman: document.querySelectorAll("main form input").length === 0,
  };
}
