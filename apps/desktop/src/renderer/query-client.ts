import { QueryClient } from "@tanstack/react-query"

/**
 * The renderer's react-query client. Tuned for a desktop app talking to the
 * local main process over IPC: no window-focus refetching, and PR/review data
 * stays fresh for a short window (it's re-fetched on demand after mutations).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 15_000,
      retry: 1
    }
  }
})
