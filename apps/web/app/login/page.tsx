import { AuthForm } from "../../components/auth-form";
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  return <AuthForm mode="login" error={(await searchParams).error} />;
}
