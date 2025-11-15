'use client';

import { useState, useEffect, useTransition } from 'react';
import { authenticateAdmin, logout } from '@/app/actions/config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
interface AuthWrapperProps {  
  children: React.ReactNode;
  isAuthenticated: boolean;
}

export default function AuthWrapper({ children, isAuthenticated }: AuthWrapperProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string>('');
  const [isLocalhost, setIsLocalhost] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
  useEffect(() => {
    // Check if we're on localhost
    const checkHost = () => {
      const host = window.location.host;
        const localhost = host.startsWith('localhost:') || host.startsWith('127.0.0.1:') || host.startsWith('nf-next-ble.vercel.app');
      setIsLocalhost(localhost);
      
      if (!localhost) {
          setError('Admin panel is only accessible from localhost');
      }
    };

    checkHost();
  }, []);

  const handleLogin = async (formData: FormData) => {
    setError('');
    startTransition(async () => {
      try {
        const result: any = await authenticateAdmin(formData);
        if (result && result.success) {
          toast({
            title: "Admin Page",
            description: "Login successful",
          });
          router.push('/');
        } else {
          setError('Invalid credentials');
          toast({
            title: "Admin Page",
            description: "Login failed",
          });
        }
      } catch (err) {
        setError('Invalid credentials');
        toast({
          title: "Admin Page",
          description: "Login failed",
        });
      }
    });
  };

  const handleLogout = async () => {
    startTransition(async () => {
      await logout();
      toast({
        title: "Admin Page",
        description: "Logout successful",
      });
      router.push('/');
    });
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center">
        <Card className="w-full max-w-md border-border">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Image src="https://placekeanu.com/100/100" alt="NF Logo" width={100} height={100} className="rounded-full" />
              <CardTitle>Admin Login</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <form action={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  name="username"
                  type="text"
                  required
                  disabled={isPending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  disabled={isPending}
                />
              </div>
              {error && (
                <div className="text-sm">{error}</div>
              )}
              <Button 
                type="submit" 
                className="w-full" 
                disabled={isPending}
              >
                {isPending ? 'Login...' : 'Login'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <div className="text-center text-sm mt-4">
          Create new admin account: <Link href="mailto:inky@enk.icu" className="hover:underline">inky@enk.icu</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative">
      <Button
        onClick={handleLogout}
        disabled={isPending}
        className="absolute top-4 right-4 px-4 py-2 rounded"
      >
        {isPending ? 'Logout...' : 'Logout'}
      </Button>
      {children}
    </div>
  );
} 