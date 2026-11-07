import { INK } from "../../components/ink";

/**
 * The home's opening painting: the delivery pack's wide ink landscape, with the site's promise centred
 * on its mist and a seal divider under it. The picture fades into the page colour at its foot.
 * On phones the band is compressed and the small print steps aside, so the first headline shares the
 * first screen; the same painting, type and seal carry the desktop opening.
 */
export function InkHero() {
  return (
    <section aria-labelledby="argus-hero-title" className="relative left-1/2 mt-3 h-[176px] w-screen -translate-x-1/2 overflow-hidden sm:h-[340px] lg:mt-0 lg:h-[380px]">
      <img
        src={INK.heroWide}
        alt=""
        width={1920}
        height={640}
        fetchPriority="high"
        decoding="async"
        className="ink-photo absolute inset-0 size-full object-cover"
      />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-[var(--bg)] sm:h-24" />
      <div className="relative z-10 flex h-full flex-col items-center justify-center px-5 pb-2 text-center">
        <h1 id="argus-hero-title" className="font-serif text-[26px] font-medium leading-[1.25] tracking-[0.08em] text-ink sm:text-[46px] lg:text-[52px]">观世界 <span className="mx-1 text-ink-3">·</span> 见未来</h1>
        <p className="mt-2 font-serif text-[12px] tracking-[0.18em] text-ink-2 sm:mt-4 sm:text-[17px]">从纷繁信息中，发现真正重要的内容</p>
        <div className="mt-3 flex items-center gap-4 sm:mt-5" aria-hidden="true">
          <span className="h-px w-10 bg-line-strong" />
          <img src={INK.sealGuan} alt="" width={26} height={27} decoding="async" className="ink-mono w-[22px] object-contain sm:w-[26px]" />
          <span className="h-px w-10 bg-line-strong" />
        </div>
        <p className="mt-4 hidden text-[9px] font-medium uppercase leading-[1.8] tracking-[0.32em] text-ink-4 sm:block">Traditional wisdom<br />for a more open tomorrow</p>
      </div>
    </section>
  );
}
