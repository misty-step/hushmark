"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

const EXAMPLES = [
  "dog barking",
  "coughing",
  "keyboard clicks",
  "sirens",
  "background music",
  "wind noise",
];

export function PromptInput({ value, onChange, disabled }: PromptInputProps) {
  return (
    <div className="space-y-3">
      <Label htmlFor="prompt" className="text-base font-medium">
        What sound should I erase?
      </Label>
      <Input
        id="prompt"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g., dog barking, coughing, keyboard clicks"
        disabled={disabled}
        className="h-12 text-lg"
        autoFocus
      />
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onChange(example)}
            disabled={disabled}
            className="rounded-full border px-3 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
