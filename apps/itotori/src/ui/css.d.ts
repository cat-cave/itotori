// fnd-spa-shell — ambient declaration so `tsc` accepts the CSS side-effect
// import in `main.tsx` (`import "@itotori/ds/styles.css"`). The bundle is
// resolved + injected by Vite at build time; tsc only needs the module to
// type-check as a side-effect import.
declare module "*.css";
