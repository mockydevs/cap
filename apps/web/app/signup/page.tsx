import { AuthForm } from "../../components/auth-form";
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  return <AuthForm mode="signup" error={(await searchParams).error} />;
}
