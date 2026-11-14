/**
 * WebView entry point. The UI has no hardware access; it only receives the
 * status and transcript channels the background layer pushes (see
 * src/shared/channels.ts).
 */

import {createRoot} from "react-dom/client"
import {MentraProvider} from "@mentra/miniapp/ui"
import "../shared/channels"
import {App} from "./App"
import "./styles.css"

const root = document.getElementById("root")
if (!root) {
  throw new Error("Missing #root element in index.html")
}

// <MentraProvider> syncs the host color scheme and calls mentra.ready() after
// the first mount, once App's mentra.on(...) subscriptions are attached. That
// ready() is what makes the background's session.ui.onOpen fire.
createRoot(root).render(
  <MentraProvider>
    <App />
  </MentraProvider>,
)
