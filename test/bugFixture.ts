// The bug-reproduction fixture, shared by the acceptance test and the redline
// end-to-end test. See test/acceptance.test.ts for what it reproduces.

export const hookPath = "app/src/hooks/useRefreshQueries.ts";
export const panelPath = "app/src/components/detail/DetailExpansionPanel.tsx";
export const pagePath = "app/src/pages/DashboardPage.tsx";
export const appPath = "app/src/App.tsx";

export const bugFixture: Record<string, string> = {
  "app/tsconfig.json":
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          jsx: "react-jsx",
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n",
  [hookPath]: `// useRefreshQueries refreshes the queries a view shows.
export function useRefreshQueries(keys: readonly string[][]) {
  const refresh = () => keys.length;
  return { refresh, isRefreshing: false };
}
`,
  "app/src/hooks/index.ts": `export { useRefreshQueries } from "./useRefreshQueries";\n`,
  [panelPath]: `export function DetailExpansionPanel({ itemId }: { itemId: string }) {
  const queryKey = ["items", "detail", itemId];
  return <section data-key={queryKey.join("/")}>{itemId}</section>;
}
`,
  [pagePath]: `import { useRefreshQueries } from "../hooks";
import { DetailExpansionPanel } from "../components/detail/DetailExpansionPanel";

const refreshQueryKeys = [["items", "list"]];

export function DashboardPage({ itemId }: { itemId: string }) {
  const { refresh } = useRefreshQueries(refreshQueryKeys);
  return (
    <main>
      <button onClick={refresh}>Refresh</button>
      <DetailExpansionPanel itemId={itemId} />
    </main>
  );
}
`,
  [appPath]: `import { DashboardPage } from "./pages/DashboardPage";

// App reaches the hook only through DashboardPage, which is the second hop the
// indirect-caller role carries.
export function App() {
  return <DashboardPage itemId="a" />;
}
`,
  "app/src/pages/DashboardPage.test.tsx": `import { useRefreshQueries } from "../hooks";

describe("DashboardPage refresh", () => {
  it("invalidates the list", () => {
    const { refresh } = useRefreshQueries([["items", "list"]]);
    expect(refresh()).toBe(1);
  });
});
`,
};
