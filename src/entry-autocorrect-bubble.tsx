import React from "react";
import { createRoot } from "react-dom/client";
import { AutocorrectBubble } from "./AutocorrectBubble";
import "./index.css";

// Its own entry so Vite tree-shakes the toast down to just what it needs — none
// of the main window's Settings/history tree, none of the popup's streaming
// machinery. This window is shown on a keystroke, so its bundle stays tiny.
const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <AutocorrectBubble />
  </React.StrictMode>,
);
