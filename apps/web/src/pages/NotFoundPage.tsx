import { Link } from 'react-router';

export default function NotFoundPage() {
  return (
    <div className="grid min-h-dvh place-items-center px-4 text-center">
      <div>
        <p className="font-mono text-sm text-muted">404</p>
        <h1 className="mt-2 text-2xl font-extrabold">Esta página no existe</h1>
        <Link to="/" className="mt-6 inline-block font-semibold text-brand hover:underline">
          Ir al panel
        </Link>
      </div>
    </div>
  );
}
