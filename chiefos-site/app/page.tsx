export default function Home() {
  return (
    <main className="min-h-screen bg-white text-gray-900">
      <div className="max-w-4xl mx-auto px-6 py-24">
        {/* Hero */}
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
          ChiefOS
        </h1>

        <p className="mt-6 text-xl text-gray-700">
          Talk to your business.
          <br />
          Get answers you can trust.
        </p>

        {/* Value */}
        <div className="mt-12 space-y-6 text-lg text-gray-700">
          <p>
            ChiefOS is an AI-native operating system for contractors and service
            businesses.
          </p>

          <p>
            It captures real business activity — receipts, expenses, time,
            revenue, and job data — and turns it into a living, auditable model
            of the business.
          </p>

          <p>
            So owners can ask real questions and get explainable answers grounded
            only in their data.
          </p>
        </div>

        {/* Principles */}
        <ul className="mt-12 space-y-3 text-gray-800">
          <li>• One mind. Many senses.</li>
          <li>• Reality first — no fabricated answers.</li>
          <li>• Job-attached records and audit spine.</li>
          <li>• Built by an owner-operator.</li>
        </ul>

        {/* CTA */}
        <div className="mt-16">
          <a
            href="mailto:hello@usechiefos.com"
            className="inline-block rounded-md bg-black px-6 py-3 text-white font-medium hover:bg-gray-800 transition"
          >
            Request early access
          </a>
        </div>

        {/* Footer */}
        <footer className="mt-24 text-sm text-gray-500">
          © {new Date().getFullYear()} ChiefOS. Privacy-first by design.
        </footer>
      </div>
    </main>
  );
}
