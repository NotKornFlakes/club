// Runs first, before the page shows: marks that scripts work, so the phone menu can start
// folded (styles.css hides it only under .js). Without scripts the menu just stays open.
document.documentElement.classList.add("js");
