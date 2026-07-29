interface Props {
  device: bigint;
  enclave: bigint;
  ticks: number;
}

/**
 * The whole thesis of the project, in one card.
 *
 * Two numbers computed by two machines that never shared a score — only an
 * input log — set side by side. They agree because both ran the same
 * `sim.wasm` over the same keypresses. If they ever disagree, the enclave's is
 * the one the contract will take.
 */
export function Verdict({ device, enclave, ticks }: Props) {
  const agree = device === enclave;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Verdict</h2>
        <span className="note">{ticks} ticks replayed</span>
      </div>
      <div className="panel-body">
        <div className={`verdict ${agree ? "agree" : "differ"}`}>
          <div className="side">
            <span className="who">This device</span>
            <span className="num">{String(device)}</span>
          </div>
          <span className="op" aria-hidden="true">
            {agree ? "=" : "≠"}
          </span>
          <div className="side">
            <span className="who">The enclave</span>
            <span className="num">{String(enclave)}</span>
          </div>
        </div>
        <p className="verdict-note">
          {agree ? (
            <>
              Same wasm, same input log, same answer. Your browser never sent a score — the enclave derived this one
              from your keypresses alone, then signed it inside the Processor&apos;s secure element.
            </>
          ) : (
            <>
              The two disagree. The enclave&apos;s number is the authoritative one; the contract only ever sees what the
              secure element signed. A mismatch means the client and the enclave are running different rules.
            </>
          )}
        </p>
      </div>
    </section>
  );
}
