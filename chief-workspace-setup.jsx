import { useState, useEffect, useRef, useCallback } from "react";

/*
 * ChiefOS — Workspace Setup Experience
 * 
 * Concept: Chief (the AI agent) is visibly "reasoning" through each setup step.
 * Instead of generic progress bars, Chief streams contextual log lines that
 * feel like watching a powerful AI build something specific to the user.
 *
 * Design: Dark terminal aesthetic with gold (#D4A853) accents.
 * Typography: monospace for logs, sans-serif for headings.
 */

/* ── Fake step definitions with "reasoning" log lines ── */
const STEPS = [
  {
    key: "verify-account",
    label: "Verify identity",
    logs: [
      "Checking authentication state…",
      "Session token validated",
      "Identity confirmed — welcome back",
    ],
  },
  {
    key: "load-signup",
    label: "Load signup context",
    logs: [
      "Retrieving signup record…",
      "Company name: {{company}}",
      "Region: {{region}}",
      "Plan intent: {{plan}}",
      "Signup context loaded",
    ],
  },
  {
    key: "resolve-workspace",
    label: "Resolve workspace",
    logs: [
      "Scanning existing tenants…",
      "No prior workspace found for this account",
      "Workspace creation authorized",
    ],
  },
  {
    key: "create-workspace",
    label: "Build workspace",
    logs: [
      "Provisioning tenant boundary…",
      "Tenant ID assigned — isolation verified",
      "Creating financial spine (transactions ledger)…",
      "Initializing job tracking schema…",
      "Timeclock policies applied — region: {{region}}",
      "Workspace created successfully",
    ],
  },
  {
    key: "record-agreement",
    label: "Record legal acceptance",
    logs: [
      "Writing terms acceptance — v2.1…",
      "Privacy policy acknowledged — v2.1…",
      "AI policy recorded — v1.0…",
      "DPA acknowledgment stored",
      "All agreements recorded with timestamp",
    ],
  },
  {
    key: "activate-access",
    label: "Activate Chief",
    logs: [
      "Configuring reasoning engine…",
      "Binding ingestion channels…",
      "Plan gating applied — {{plan}}",
      "Chief is ready",
    ],
  },
];

/* ── Helpers ── */
function interpolate(text, vars) {
  return text
    .replace("{{company}}", vars.company || "—")
    .replace("{{region}}", vars.region || "Canada")
    .replace("{{plan}}", vars.plan || "Free");
}

function useTypewriter(text, speed = 28) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDisplayed("");
    setDone(false);
    if (!text) return;
    let i = 0;
    const iv = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(iv);
        setDone(true);
      }
    }, speed);
    return () => clearInterval(iv);
  }, [text, speed]);

  return { displayed, done };
}

/* ── Blinking cursor ── */
function Cursor({ visible = true }) {
  if (!visible) return null;
  return (
    <span
      style={{
        display: "inline-block",
        width: 2,
        height: "1.1em",
        background: "#D4A853",
        marginLeft: 2,
        verticalAlign: "text-bottom",
        animation: "cursorBlink 0.9s step-end infinite",
      }}
    />
  );
}

/* ── Single log line with typewriter ── */
function LogLine({ text, onDone, isLast, vars }) {
  const interpolated = interpolate(text, vars);
  const { displayed, done } = useTypewriter(interpolated, 22);

  useEffect(() => {
    if (done && onDone) onDone();
  }, [done, onDone]);

  const isSuccess =
    interpolated.includes("successfully") ||
    interpolated.includes("confirmed") ||
    interpolated.includes("ready") ||
    interpolated.includes("loaded") ||
    interpolated.includes("recorded with") ||
    interpolated.includes("verified") ||
    interpolated.includes("authorized");

  return (
    <div
      style={{
        fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
        fontSize: 13,
        lineHeight: 1.7,
        color: isSuccess && done ? "#6BCB77" : "rgba(168, 160, 144, 0.9)",
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
      }}
    >
      <span style={{ color: "rgba(212, 168, 83, 0.4)", userSelect: "none" }}>›</span>
      <span>
        {displayed}
        {!done && <Cursor />}
      </span>
    </div>
  );
}

/* ── Step block ── */
function StepBlock({ step, isActive, isComplete, vars, onComplete }) {
  const [visibleLogs, setVisibleLogs] = useState(0);
  const [allDone, setAllDone] = useState(false);

  useEffect(() => {
    if (isActive && visibleLogs === 0) {
      setVisibleLogs(1);
    }
  }, [isActive, visibleLogs]);

  const handleLogDone = useCallback(() => {
    if (visibleLogs < step.logs.length) {
      // Small pause between lines for realism
      setTimeout(() => setVisibleLogs((v) => v + 1), 180 + Math.random() * 300);
    } else if (!allDone) {
      setAllDone(true);
      setTimeout(() => onComplete?.(), 400);
    }
  }, [visibleLogs, step.logs.length, allDone, onComplete]);

  if (!isActive && !isComplete) return null;

  return (
    <div style={{ marginBottom: 20, opacity: isComplete && !isActive ? 0.5 : 1, transition: "opacity 0.6s" }}>
      {/* Step header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 6,
        }}
      >
        {/* Status indicator */}
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: isComplete ? "#6BCB77" : "#D4A853",
            boxShadow: isComplete ? "0 0 8px rgba(107,203,119,0.4)" : "0 0 8px rgba(212,168,83,0.3)",
            transition: "all 0.4s",
          }}
        />
        <span
          style={{
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: isComplete ? "#6BCB77" : "#D4A853",
          }}
        >
          {step.label}
        </span>
        {isComplete && (
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              color: "rgba(107,203,119,0.5)",
              marginLeft: "auto",
            }}
          >
            ✓ complete
          </span>
        )}
      </div>

      {/* Log lines */}
      <div style={{ paddingLeft: 18 }}>
        {step.logs.slice(0, visibleLogs).map((log, i) => (
          <LogLine
            key={i}
            text={log}
            vars={vars}
            isLast={i === step.logs.length - 1}
            onDone={i === visibleLogs - 1 ? handleLogDone : undefined}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Chief branding mark ── */
function ChiefMark() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
      {/* Stylized "C" mark */}
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 8,
          background: "linear-gradient(135deg, rgba(212,168,83,0.15) 0%, rgba(212,168,83,0.05) 100%)",
          border: "1px solid rgba(212,168,83,0.2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'Georgia', serif",
          fontSize: 20,
          fontWeight: 700,
          color: "#D4A853",
        }}
      >
        C
      </div>
      <div>
        <div
          style={{
            fontFamily:
              "'SF Pro Display', 'Instrument Sans', -apple-system, sans-serif",
            fontSize: 16,
            fontWeight: 600,
            color: "#E8E0D4",
            letterSpacing: "-0.01em",
          }}
        >
          Chief
        </div>
        <div
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            color: "rgba(168, 160, 144, 0.6)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Workspace Setup
        </div>
      </div>
    </div>
  );
}

/* ── Final "ready" state ── */
function ReadyState() {
  const [opacity, setOpacity] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setOpacity(1), 100);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      style={{
        marginTop: 32,
        padding: "24px 20px",
        background: "linear-gradient(135deg, rgba(107,203,119,0.06) 0%, rgba(212,168,83,0.04) 100%)",
        border: "1px solid rgba(107,203,119,0.15)",
        borderRadius: 8,
        opacity,
        transition: "opacity 0.8s ease",
      }}
    >
      <div
        style={{
          fontFamily: "'SF Pro Display', -apple-system, sans-serif",
          fontSize: 18,
          fontWeight: 600,
          color: "#E8E0D4",
          marginBottom: 6,
        }}
      >
        Your workspace is ready.
      </div>
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          color: "rgba(168, 160, 144, 0.7)",
        }}
      >
        Chief has full context. Redirecting you now…
      </div>
    </div>
  );
}

/* ── Main component ── */
export default function ChiefWorkspaceSetup() {
  // In production, these come from the pending signup record
  const vars = {
    company: "Jutras Contracting",
    region: "Ontario, Canada",
    plan: "Starter",
  };

  const [activeIndex, setActiveIndex] = useState(0);
  const [completedSteps, setCompletedSteps] = useState(new Set());
  const [allComplete, setAllComplete] = useState(false);
  const scrollRef = useRef(null);

  // Auto-scroll as new content appears
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  // Start first step immediately
  useEffect(() => {
    const t = setTimeout(() => setActiveIndex(0), 600);
    return () => clearTimeout(t);
  }, []);

  const handleStepComplete = useCallback(
    (stepIndex) => {
      setCompletedSteps((prev) => new Set([...prev, stepIndex]));
      if (stepIndex < STEPS.length - 1) {
        setActiveIndex(stepIndex + 1);
      } else {
        setAllComplete(true);
      }
    },
    []
  );

  // Elapsed timer
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (allComplete) return;
    const iv = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(iv);
  }, [allComplete]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0C0B0A",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 20px",
      }}
    >
      {/* Subtle background grain */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E")`,
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          maxWidth: 560,
        }}
      >
        <ChiefMark />

        {/* Terminal-like container */}
        <div
          style={{
            background: "rgba(18, 17, 15, 0.8)",
            border: "1px solid rgba(212, 168, 83, 0.1)",
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          {/* Title bar */}
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid rgba(212, 168, 83, 0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", gap: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "rgba(212,168,83,0.3)" }} />
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "rgba(212,168,83,0.15)" }} />
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "rgba(212,168,83,0.08)" }} />
            </div>
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                color: "rgba(168, 160, 144, 0.4)",
                letterSpacing: "0.05em",
              }}
            >
              chief://workspace/setup · {elapsed}s
            </div>
          </div>

          {/* Scrollable log area */}
          <div
            ref={scrollRef}
            style={{
              padding: "20px 16px",
              maxHeight: 440,
              overflowY: "auto",
              scrollBehavior: "smooth",
            }}
          >
            {STEPS.map((step, i) => (
              <StepBlock
                key={step.key}
                step={step}
                isActive={activeIndex === i}
                isComplete={completedSteps.has(i)}
                vars={vars}
                onComplete={() => handleStepComplete(i)}
              />
            ))}

            {allComplete && <ReadyState />}
          </div>
        </div>

        {/* Bottom status line */}
        <div
          style={{
            marginTop: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 4px",
          }}
        >
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              color: "rgba(168, 160, 144, 0.35)",
            }}
          >
            {allComplete
              ? "All systems nominal"
              : `Step ${activeIndex + 1} of ${STEPS.length}`}
          </div>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              color: "rgba(168, 160, 144, 0.35)",
            }}
          >
            ChiefOS v1.0
          </div>
        </div>
      </div>

      {/* Keyframe for cursor blink */}
      <style>{`
        @keyframes cursorBlink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }

        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap');

        /* Scrollbar styling */
        div::-webkit-scrollbar {
          width: 4px;
        }
        div::-webkit-scrollbar-track {
          background: transparent;
        }
        div::-webkit-scrollbar-thumb {
          background: rgba(212, 168, 83, 0.15);
          border-radius: 2px;
        }
      `}</style>
    </div>
  );
}
