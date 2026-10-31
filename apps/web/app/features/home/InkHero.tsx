import { INK } from "../../components/ink";

/**
 * The home's opening painting: the delivery pack's wide ink landscape, with the site's promise centred
 * on its mist and a seal divider under it. The picture fades into the page colour at its foot.
 */
export function InkHero() {
  return (
    <section aria-labelledby="argus-hero-title" className="relative left-1/2 mt-3 h-[300px] w-screen -translate-x-1/2 overflow-hidden sm:h-[340px] lg:mt-0 lg:h-[380px]">
      <img
        src={INK.heroWide}
        alt=""
        width={1920}
        height={640}
        fetchPriority="high"
        decoding="async"
        className="ink-photo absolute inset-0 size-full object-cover"
      />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-[var(--bg)]" />
      <div className="relative z-10 flex h-full flex-col items-center justify-center px-5 pb-2 text-center">
        <h1 id="argus-hero-title" className="font-serif text-[38px] font-medium leading-[1.25] tracking-[0.08em] text-ink sm:text-[46px] lg:text-[52px]">观世界 <span className="mx-1 text-ink-3">·</span> 见未来</h1>
        <p className="mt-4 font-serif text-[15px] tracking-[0.18em] text-ink-2 sm:text-[17px]">从纷繁信息中，发现真正重要的内容</p>
        <div className="mt-5 flex items-center gap-4" aria-hidden="true">
          <span className="h-px w-10 bg-line-strong" />
          <img src={INK.sealGuan} alt="" width={26} height={27} decoding="async" className="ink-mono w-[26px] object-contain" />
          <span className="h-px w-10 bg-line-strong" />
        </div>
        <p className="mt-4 text-[8px] font-medium uppercase leading-[1.8] tracking-[0.32em] text-ink-4 sm:text-[9px]">Traditional wisdom<br />for a more open tomorrow</p>
      </div>
    </section>
  );
}
