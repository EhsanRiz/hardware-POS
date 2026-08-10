// ESC/POS raster logo (base64) printed at the top of every receipt, centered.
//
// Empty by default — no logo is printed until you generate one for this shop.
// To add it: convert the shop logo to a 1-bit bitmap no wider than the paper
// (384px for 58mm, 576px for 80mm), wrap it in a GS v 0 raster command, and
// paste the base64 here. `buildEscPos` in print.ts feeds it straight to RawBT.
export const LOGO_ESCPOS_B64 = "";
