"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

interface RightsCheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function RightsCheckbox({ checked, onCheckedChange }: RightsCheckboxProps) {
  return (
    <div className="flex items-start gap-3">
      <Checkbox
        id="rights"
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="mt-0.5"
      />
      <Label htmlFor="rights" className="text-sm text-muted-foreground leading-relaxed">
        I own or have rights to edit this content
      </Label>
    </div>
  );
}
