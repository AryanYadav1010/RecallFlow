import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import "./style.css";
const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.recallflow ? (
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    ) : (
      <div className="browser-notice">
        <h1>RecallFlow is a desktop companion.</h1>
        <p>
          Launch with <code>npm run dev</code> to connect to secure local
          storage and audio services.
        </p>
      </div>
    )}
  </React.StrictMode>,
);
