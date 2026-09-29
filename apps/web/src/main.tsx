import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { Toaster } from './components/ui/Feedback';
import { queryClient } from './lib/queries';
import { router } from './router';
import { useAuth } from './stores/auth';
import './styles.css';

void useAuth.getState().bootstrap();

// Whoever signs out (or loses the session) must not leave cached data behind.
useAuth.subscribe((state, prev) => {
  if (prev.status === 'authenticated' && state.status === 'anonymous') queryClient.clear();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
