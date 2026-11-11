import { plausibleClass } from '../src/lib/track';
import { classifyLinkTarget } from '../src/lib/linkTarget';

describe('plausibleClass', () => {
  it('encodes the event name and props with + for spaces', () => {
    expect(plausibleClass('CTA Click', { cta: '404 Home' }))
      .toBe('plausible-event-name=CTA+Click plausible-event-cta=404+Home');
  });

  it('emits only the name when there are no props', () => {
    expect(plausibleClass('Footer Click')).toBe('plausible-event-name=Footer+Click');
  });
});

describe('classifyLinkTarget', () => {
  it('maps detail pages to an entity type without the id', () => {
    expect(classifyLinkTarget('/block/123456')).toEqual({ entity: 'block' });
    expect(classifyLinkTarget(`/transactions/${'a'.repeat(64)}`)).toEqual({ entity: 'tx' });
    expect(classifyLinkTarget('/tx/abc')).toEqual({ entity: 'tx' });
    expect(classifyLinkTarget('/addresses/SomeAddr123')).toEqual({ entity: 'address' });
    expect(classifyLinkTarget('/projects/einstein')).toEqual({ entity: 'project' });
  });

  it('keeps static routes and collapses archives and unknown id-like paths', () => {
    expect(classifyLinkTarget('/projects/history')).toEqual({ to: '/projects/history' });
    expect(classifyLinkTarget('/blocks')).toEqual({ to: '/blocks' });
    expect(classifyLinkTarget('/blocks/2024/05/12')).toEqual({ to: 'archive-day' });
    expect(classifyLinkTarget('/blocks/2024')).toEqual({ to: 'archive-year' });
    expect(classifyLinkTarget('/something/0xdeadbeef')).toEqual({ to: 'other' });
  });
});
