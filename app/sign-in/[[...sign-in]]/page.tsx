import { SignIn } from "@clerk/nextjs";
import { isClerkConfigured } from "@/lib/server/auth";

export default function SignInPage() {
  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-6 px-4 py-12">
      <div className="w-full max-w-sm text-center">
        <p className="text-sm text-muted-foreground">Tessera</p>
        <h1 className="mt-2 text-2xl font-semibold">Вход в рабочее место</h1>
      </div>
      {isClerkConfigured() ? (
        <SignIn path="/sign-in" routing="path" forceRedirectUrl="/" signUpForceRedirectUrl="/" />
      ) : (
        <p role="alert" className="max-w-sm text-center text-sm text-destructive">
          Авторизация временно недоступна. Обратитесь к администратору.
        </p>
      )}
    </main>
  );
}
