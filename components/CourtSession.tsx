import type { CaseFile } from "@/schemas/case";
import { getCaseReport } from "@/lib/cases";
import { readTally } from "@/lib/juryStore";
import { CourtroomApp } from "./CourtroomApp";

/** Server wrapper: proves the case with the solver and seeds the jury tally. */
export async function CourtSession({ caseFile }: { caseFile: CaseFile }) {
  const report = getCaseReport(caseFile);
  const tally = await readTally(caseFile.id);
  return (
    <CourtroomApp
      caseFile={caseFile}
      report={report}
      initialTally={tally}
      siteOrigin={process.env.NEXT_PUBLIC_SITE_URL ?? null}
    />
  );
}

export function EmptyDocket() {
  return (
    <main className="empty-docket">
      <div>
        <p className="display" style={{ fontSize: 56, lineHeight: "52px", margin: 0 }}>
          NO TRIAL IN SESSION
        </p>
        <p className="case-meta">The docket is empty. Add a case to content/cases/ and reload.</p>
      </div>
    </main>
  );
}
