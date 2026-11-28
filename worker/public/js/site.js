// @ts-check
// The site menu on phones: the Menu button opens and closes it.
const button = document.querySelector(".menu-button");
const nav = document.getElementById("site-nav");
if (button && nav) {
  button.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    button.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav.classList.contains("open")) {
      nav.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
      if (button instanceof HTMLElement) button.focus();
    }
  });
}
