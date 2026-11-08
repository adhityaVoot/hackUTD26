export function PlaceholderScreen({ title }: { title: string }) {
  return (
    <section className="screen">
      <h1>{title}</h1>
      <p className="empty">This screen is next.</p>
    </section>
  );
}
