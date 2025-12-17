"use client";

import { Button } from "@/components/ui/button";
import { Eraser, Loader2 } from "lucide-react";

interface EraseButtonProps {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}

export function EraseButton({ onClick, disabled, loading }: EraseButtonProps) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled || loading}
      size="lg"
      className="w-full"
    >
      {loading ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Processing...
        </>
      ) : (
        <>
          <Eraser className="mr-2 h-4 w-4" />
          Erase
        </>
      )}
    </Button>
  );
}
