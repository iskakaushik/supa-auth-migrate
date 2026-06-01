import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TriangleAlert } from "lucide-react";

export default function AuthCodeError() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm text-center">
        <CardHeader className="items-center">
          <div className="mx-auto mb-2 flex size-11 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
            <TriangleAlert className="size-5" />
          </div>
          <CardTitle>Sign-in failed</CardTitle>
          <CardDescription>
            Something went wrong completing the sign-in. Please try again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            href="/login"
            className={buttonVariants({ variant: "outline", className: "w-full" })}
          >
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
