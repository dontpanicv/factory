import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/schibsted-grotesk";
import { render } from "preact";
import { App } from "./app.tsx";

const root = document.getElementById("app");
if (root === null) {
  throw new Error("The page has no #app element.");
}
render(<App />, root);
