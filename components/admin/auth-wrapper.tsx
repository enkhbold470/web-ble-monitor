'use client';

import { useState, useTransition } from 'react';
import { authenticateAdmin, logout } from '@/app/actions/config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Shield } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface AuthWrapperProps {
  children: React.ReactNode;
  isAuthenticated: boolean;
}

export default function AuthWrapper({ children, isAuthenticated }: AuthWrapperProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string>('');
  const { toast } = useToast();
  const router = useRouter();

  const handleLogin = async (formData: FormData) => {
    setError('');
    startTransition(async () => {
      try {
        const result = await authenticateAdmin(formData);
        if (result?.success) {
          toast({
            title: 'Signed in',
            description: 'Login successful',
          });
          router.refresh();
        } else {
          setError('Invalid credentials');
        }
      } catch (err) {
        const message =
          err instanceof Error && err.message.includes('Too many login')
            ? 'Too many login attempts. Try again later.'
            : 'Invalid credentials';
        setError(message);
        toast({
          title: 'Login failed',
          description: message,
          variant: 'destructive',
        });
      }
    });
  };

  const handleLogout = async () => {
    startTransition(async () => {
      await logout();
      toast({
        title: 'Signed out',
        description: 'Logout successful',
      });
      router.refresh();
    });
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-4">
        <Card className="w-full max-w-md border-border">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Shield className="h-10 w-10 text-primary" aria-hidden />
              <CardTitle>Sign in</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <form action={handleLogin} className="space-y-4" autoComplete="off">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  name="username"
                  type="text"
                  required
                  disabled={isPending}
                  autoComplete="username"
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
                  autoComplete="current-password"
                />
              </div>
              {error && (
                <div className="text-sm text-destructive" role="alert">
                  {error}
                </div>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={isPending}
              >
                {isPending ? 'Signing in...' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>
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
        {isPending ? 'Signing out...' : 'Sign out'}
      </Button>
      {children}
    </div>
  );
}
