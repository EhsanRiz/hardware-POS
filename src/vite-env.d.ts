/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_CURRENCY?: string;
  readonly VITE_SHOP_NAME?: string;
  readonly VITE_RECEIPT_WIDTH?: string;
  readonly VITE_TIP_PERCENTS?: string;
  readonly VITE_PRINT_WIDTH_SCALE?: string;
  readonly VITE_PRINT_HEIGHT_SCALE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
