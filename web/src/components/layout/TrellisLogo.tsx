import { cn } from "@/lib/utils";

type TrellisLogoProps = {
  className?: string;
  size?: number;
  variant?: "default" | "inverted";
};

export function TrellisLogo({
  className,
  size = 24,
  variant = "default",
}: TrellisLogoProps) {
  const isInverted = variant === "inverted";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-label="Trellis"
    >
      <rect
        width="24"
        height="24"
        rx="6"
        className={isInverted ? "fill-primary-foreground" : "fill-primary"}
      />
      {/* 垂直晶格 3 根 */}
      <rect
        x="5"
        y="5"
        width="2"
        height="14"
        rx="1"
        className={isInverted ? "fill-primary" : "fill-primary-foreground"}
      />
      <rect
        x="11"
        y="5"
        width="2"
        height="14"
        rx="1"
        className={isInverted ? "fill-primary" : "fill-primary-foreground"}
      />
      <rect
        x="17"
        y="5"
        width="2"
        height="14"
        rx="1"
        className={isInverted ? "fill-primary" : "fill-primary-foreground"}
      />
      {/* 水平晶格 3 根 */}
      <rect
        x="5"
        y="5"
        width="14"
        height="2"
        rx="1"
        className={isInverted ? "fill-primary" : "fill-primary-foreground"}
      />
      <rect
        x="5"
        y="11"
        width="14"
        height="2"
        rx="1"
        className={isInverted ? "fill-primary" : "fill-primary-foreground"}
      />
      <rect
        x="5"
        y="17"
        width="14"
        height="2"
        rx="1"
        className={isInverted ? "fill-primary" : "fill-primary-foreground"}
      />
    </svg>
  );
}
