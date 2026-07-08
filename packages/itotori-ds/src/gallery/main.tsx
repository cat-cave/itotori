import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Gallery } from "./Gallery.js";

const container = document.getElementById("root");
if (!container) throw new Error("gallery: #root not found");

createRoot(container).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
