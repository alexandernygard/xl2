import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Toaster, TooltipProvider } from "@alexandernygard/components"
import { App } from "./App"
import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
      <Toaster />
    </TooltipProvider>
  </StrictMode>,
)
