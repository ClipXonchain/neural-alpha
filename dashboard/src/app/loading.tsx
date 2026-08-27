export default function Loading() {
  return (
    <div className="min-h-screen bg-void">
      <div className="h-[57px] border-b border-border-dim bg-surface" />
      <main className="px-4 md:px-6 py-4 flex flex-col gap-4 max-w-[1600px] mx-auto">
        <div className="h-16 rounded-xl bg-surface border border-border-dim animate-pulse" />
        <div className="h-12 rounded-xl bg-surface border border-border-dim animate-pulse" />
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3 h-[260px] rounded-xl bg-surface border border-border-dim animate-pulse" />
          <div className="lg:col-span-2 h-[260px] rounded-xl bg-surface border border-border-dim animate-pulse" />
        </div>
      </main>
    </div>
  );
}
