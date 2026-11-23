"use client";

import { useState, useTransition } from "react";

import { acceptInviteAction } from "@/app/(app)/settings/actions";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";

export function AcceptInvite({ token }: { token: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await acceptInviteAction(token);
            if (result && !result.ok) setError(result.error.message);
          })
        }
      >
        {pending ? "Joining…" : "Accept invitation"}
      </Button>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}
