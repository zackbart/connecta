import { QueryClient } from "@tanstack/react-query";

// Identity changes clear the cache. No automatic retry, refocus fetch, or
// mutation replay: the existing session fence continues to own those actions.
export const queryClient = new QueryClient({ defaultOptions: {
  queries: { retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false },
  mutations: { retry: false },
} });
