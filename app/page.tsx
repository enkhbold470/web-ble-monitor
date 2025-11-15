export const dynamic = "force-dynamic";
import BleReader from "@/components/BleReader";
import AuthWrapper from "@/components/admin/auth-wrapper";
import { isAuthenticated } from "@/app/actions/config";

export default async function Home() {
  const authenticated = await isAuthenticated();
  return (
    <AuthWrapper isAuthenticated={authenticated}>
      <div className="min-h-screen ">
        
        <BleReader />
      </div>
    </AuthWrapper>
  );
}