import { JEV_COMPLETION_SKIPPED, type JevReceipt } from "@codeden/contracts";

export function JevStatus({ receipt }: { receipt: JevReceipt }) {
  if (receipt.status === "not configured") {
    return <p className="text-2xs">{JEV_COMPLETION_SKIPPED}</p>;
  }
  return (
    <details className="text-2xs">
      <summary>Jev · {receipt.status}</summary>
      <dl className="break-all">
        <dt>Head</dt>
        <dd>{receipt.head}</dd>
        {receipt.inputSha256 && (
          <>
            <dt>Receipt</dt>
            <dd>{receipt.inputSha256}</dd>
          </>
        )}
        {receipt.historyPath && (
          <>
            <dt>History file</dt>
            <dd>{receipt.historyPath}</dd>
          </>
        )}
        {receipt.historySha256 && (
          <>
            <dt>History SHA-256</dt>
            <dd>{receipt.historySha256}</dd>
          </>
        )}
      </dl>
      <p className="whitespace-pre-wrap">{receipt.reasons.join("\n")}</p>
    </details>
  );
}
