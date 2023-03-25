/* eslint-disable max-lines-per-function */
import { UIAnimation } from './ui-animation';
import { IUIBinding, toUICallback, UIBinding } from "./ui-binding";
import { UIView } from "./ui-view";

export class UI {
  // public static bindings: Record<string, UIBinding> = {};
  private static initialized = false;
  public static id = 0;

  public static views: UIView[] = [];
  public static destroyed: UIView[] = [];
  public static globals = new UIView();

  public static leaveAttributes = false;

  private static readonly regexReplace = /([\S\s]*?)\$\{([^}]*?[<=@!]=[*=>|][^}]*?)\}([\S\s]*)/m;
  private static readonly regexAttribute = /^\s*(\S*?)\s*([<=@!])=([*=>|])\s*(\S*?)\s*$/;
  private static readonly regexValue = /(?<before>[\S\s]*?)\$\{\s*(?<property>[\s\S]*?)\s*\}(?<after>[\S\s]*)/m;
  private static readonly regexConditionalValue = /^\s*(.+?)\s*([=!])\s*(\S+)/;
  private static readonly regexSplitConditionalValue = /^(.+?)([=!])(.*)/;

  private static bindingCounter = 0;
  private static _queue: any[] = [];
  private static _nextQueue: any[] = [];

  public static initialize(rafOrInterval: boolean | number = true): void {
    UI.initialized = true;
    if (rafOrInterval === false) {
      return;
    }
    if (rafOrInterval === true) {
      const tick = () => {
        UI.update();
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
      return;
    }
    setInterval(() => UI.update(), 1000 / rafOrInterval);
  }

  public static create(parent: HTMLElement, template: string | HTMLElement, model = {}, options: { parent: any; prepare: boolean; sibling: any } = { parent: null, prepare: true, sibling: null }): UIView {
    if (typeof template === 'string') {
      const doc = parent?.ownerDocument ?? document; // as any;
      // while (doc.parentNode != null) {
      //   doc = doc.parentNode;
      // }
      if (template.startsWith('#')) {
        template = doc.querySelector(template)!.innerHTML;
      }
      const container = doc.createElement('div');
      container.innerHTML = options.prepare ? UI.prepare(template) : template;
      template = container.firstElementChild as HTMLElement;
    }
    const view = UIView.create(parent, template, model, options);
    if (view.parent === UI) {
      UI.views.push(view);
    }
    if (!UI.initialized) {
      UI.initialize();
    }
    return view;
  }

  public static play(animation: string | UIAnimation, element?: HTMLElement): UIAnimation {
    if (typeof animation === 'string') {
      animation = this.globals.animations.find(anim => anim.name === animation)!.clone();
      return animation.play(element);
    }
    return animation.play();
  }

  public static queue(func: any): void {
    this._nextQueue.push(func);
  }

  public static parse(element: Element, object: any, view: UIView, parent: any): UIBinding[] {
    const bindings: UIBinding[] = [];
    if (element.nodeType === 3) { // text
      let text = element.textContent;
      let match = text!.match(UI.regexValue);
      while (match != null) {
        const first = match[1];
        let property = match[2];
        text = match[3];

        let oneTime = false;
        if (property.startsWith('|')) {
          oneTime = true;
          property = property.slice(1).trimStart();
        }

        const propertyMatch = property.match(UI.regexConditionalValue);
        let value;
        let toUI: boolean | toUICallback = true;
        if (propertyMatch) {
          property = propertyMatch[3];
          value = `${propertyMatch[2]}${propertyMatch[1]}`;
          toUI = function (value, _lastValue, property, _object, fixedValue) {
            const truthy = fixedValue[0] === '=';
            fixedValue = fixedValue.slice(2, -1); // Remove ''
            return !!value === truthy ? fixedValue : '';
          };
        }

        let clone = element.cloneNode() as Element;
        element.textContent = first;
        UI.parentElement(element, parent).insertBefore(clone, element.nextSibling);
        bindings.push(UI.bind({ selector: clone, attribute: 'textContent', object, property, parent: view, oneTime, value, toUI }));
        element = clone;

        clone = element.cloneNode() as Element;
        clone.textContent = text;
        UI.parentElement(element, parent).insertBefore(clone, element.nextSibling);
        element = clone;
        match = text.match(UI.regexValue);
      }
    }
    else {
      bindings.push(...Object.keys(element.attributes ?? []).reverse().map((attribute): UIBinding[] => {
        const bindings: UIBinding[] = [];
        if (element instanceof Comment) {
          return [];
        }
        const attr = element.attributes[attribute as any];
        if (attr.name.startsWith('pui.')) {
          const match = attr.value.match(UI.regexAttribute);
          let [_ignore, name, toUI, fromUI, value] = match!;
          let fixedValue: string | undefined;
          let template;
          let oneTime = false;
          // let type: IUIBindingType = '';
          if (toUI !== '@') {
            const fixed = name.match(/^'(.*?)'$/);
            if (fixed != null) { // 'value' ==> fixed value
              // type = 'fixed-value';
              fixedValue = fixed[1];
              element.setAttribute('value', fixedValue);
              name = element.nodeName.toLowerCase() === 'option' ? 'selected' : 'checked';
              fromUI = ((value: string) => value ? fixedValue : undefined) as unknown as string;
              toUI = ((value: string) => value === fixedValue) as unknown as string;
            } else if (name === '') {
              if (fromUI === '>') { // ==> reference
                // type = 'reference';
                const { target, property } = UI.resolveProperty(object, value);
                target[property] = element;
                return [];
              } else { // === or !== conditional
                // type = 'conditional';
                const comment = document.createComment(attr.name);
                UI.parentNode(element, parent).insertBefore(comment, element);
                UI.parentNode(element, parent).removeChild(element);
                element.removeAttribute(attr.name);
                template = element;
                element = comment as unknown as Element;
                name = (toUI === '=') as unknown as string;
                toUI = true as unknown as string;
                if (fromUI === '|') { // ==| or !=| conditional one time
                  oneTime = true;
                }
              }
            } else if (fromUI === '=' && toUI === '=') { // component === (state)
              const parentNode = UI.parentNode(element, parent);
              if (parentNode.nodeType !== 8) {
                const comment = document.createComment(attr.name);
                parentNode.insertBefore(comment, element);
                parentNode.removeChild(element);
                element.removeAttribute(attr.name);
                element = comment as unknown as Element;
              } else {
                element = parentNode as unknown as Element;
              }
              template = name;
              oneTime = true;
              toUI = true as unknown as string;
            } else if (fromUI === '*') { // *=> event
              // type = 'event';
              const comment = document.createComment(attr.name);
              UI.parentNode(element, parent).insertBefore(comment, element);
              UI.parentNode(element, parent).removeChild(element);
              element.removeAttribute(attr.name);
              template = element;
              element = comment as unknown as Element;
            } else if (fromUI === '|') { // attr ==| prop one time
              oneTime = true;
            } else if (name !== 'checked') {
              element.setAttribute(name, '');
            }
          }
          return [UI.bind({
            selector: element, attribute: name, value: fixedValue, object, property: value, template: template as HTMLElement, // type,
            toUI: typeof toUI === 'string' ? toUI === '<' : toUI,
            fromUI: typeof fromUI === 'string' ? fromUI === '>' : fromUI,
            atEvent: toUI === '@',
            parent: view,
            oneTime,
          })];
        }
        const parts = [attr.value];
        let index = 0;
        let match = parts[index].match(UI.regexValue);
        while (match != null) {
          let { before, property, after } = match.groups as any;
          let oneTime = false;
          if (property.startsWith('|')) {
            oneTime = true;
            property = property.slice(1).trimStart();
          }

          const propertyMatch = property.match(UI.regexConditionalValue);
          let value;
          if (propertyMatch) {
            property = propertyMatch[3];
            value = `${propertyMatch[2]}${propertyMatch[1]}`;
          }

          bindings.push(UI.bind({
            selector: element,
            attribute: attr.name,
            object, property, oneTime,
            toUI(newValue: any, _oldValue: any, name: string, model: any, fixedValue: any): any {
              if (this.oneTime) {
                // console.log('PARTS', name, parts, this);
                const index = parts.indexOf(name);
                if (index > -1) {
                  parts[index] = UI.resolveValue(model, name);
                  parts[index - 1] += parts[index] + parts[index + 1];
                  parts.splice(index, 2);
                }
              }
              const value = parts.map((part, index) => {
                if (index % 2 === 0) {
                  return part;
                }
                const match = part.match(UI.regexSplitConditionalValue);
                if (match) {
                  const value = part === `${name}${fixedValue}` ? newValue : UI.resolveValue(model, match[1]);
                  const truthy = match[2] === '=';
                  return !!value === truthy ? match[3].slice(1, -1) : '';
                }
                return part === name ? newValue : UI.resolveValue(model, part);
              }).join('');
              element.setAttribute(attr.name, value);
              return value;
            },
            parent: view,
            value,
          }));
          parts[index++] = before;
          parts[index++] = `${property}${value ?? ''}`;
          parts[index] = after;
          match = parts[index].match(UI.regexValue);
        }
        return bindings;
      }).flat());

      // It's a repeater, clear all bindings except the template
      if (element instanceof Comment) {
        return bindings.filter(binding => {
          if (binding.template != null) {
            return true;
          }
          binding.unbind();
          return false;
        });
      }

      if (!UI.leaveAttributes) {
        for (let i = Object.keys(element.attributes ?? []).length - 1; i >= 0; i--) {
          const attr = element.attributes[Object.keys(element.attributes ?? [])[i] as unknown as number];
          if (attr.name.startsWith('pui.')) {
            element.removeAttribute(attr.name);
          }
        }
      }

      bindings.push(...Array.from(element.childNodes).map(child => UI.parse(child as HTMLElement, object, view, parent)).flat());
    }
    return bindings;
  }

  public static bind(options: IUIBinding): UIBinding {
    const binding = UIBinding.create(options);
    // UI.bindings[binding.id] = binding;
    return binding;
  }

  public static unbind(binding: UIBinding): void {
    binding.destroy();
    // delete UI.bindings[binding.id];
    if (binding.parent !== UI) {
      const bindings = (binding.parent as UIView).bindings;
      const index = bindings.indexOf(binding);
      if (index > -1) {
        bindings.splice(index, 1);
      }
    }
  }

  public static update(): void {
    this._queue.forEach(item => item());
    this._queue = this._nextQueue;
    this._nextQueue = [];

    // console.log('UI.update', Object.keys(UI.bindings).length);
    this.views.forEach(view => view.updateFromUI());
    this.views.forEach(view => view.updateToUI());
    this.views.forEach(view => view.updateAtEvents());

    const now = performance.now();
    [...this.views, this.globals].forEach(view => view.updateAnimations(now));

    this.views.forEach(view => {
      view.updateMove();
    });
    this.destroyed.forEach(view => {
      switch (view.destroyed) {
        case 'queue':
          if (view.state === 'rendered') {
            view.destroyed = 'destroy';
          } else {
            // console.log('UI.update destroyed "queue"', view.state, view.element);
            view.updateToUI();
          }
          break;
        case 'destroy': {
          view.terminate();
          const index = this.destroyed.findIndex(destroyed => view === destroyed);
          if (index > -1) {
            this.destroyed.splice(index, 1);
          }
        }
      }
    });
  }

  public static resolveProperty(object: any, property: string): { target: any; property: string } {
    property = property.replace('[', '.').replace(']', '.');
    const properties = property.split('.').filter(prop => (prop ?? '').length > 0);
    while (properties[0] === '$parent' && object.$parent != null) {
      object = object.$parent;
      properties.shift();
    }
    let target = '$model' in object ? object.$model : object;
    while (properties.length > 1) {
      target = target[properties.shift()!];
    }
    return { target, property: properties[0] };
  }

  public static resolveValue(object: any, prop: string): any {
    let guard = 0;
    do {
      const { target, property } = UI.resolveProperty(object, prop);
      if (target != null && property in target) {
        return target[property];
      }
      object = object.$parent;
    } while (object != null && guard++ < 1000);
  }

  public static parentElement(element: Element, parent: UIView | UIBinding | null): HTMLElement {
    const parentElement = element.parentElement;
    if (parentElement != null) {
      return parentElement;
    }
    while (parent != null && (parent.element == null || parent.element === element)) {
      parent = parent.parent as UIView | UIBinding;
    }
    return parent?.element as HTMLElement;
  }

  public static parentNode(element: Element, parent: UIView | UIBinding | null): Node {
    const parentNode = element.parentNode;
    if (parentNode != null) {
      return parentNode;
    }
    while (parent != null && (parent.element == null || parent.element === element)) {
      parent = parent.parent as UIView | UIBinding;
    }
    return parent?.element!;
  }

  private static prepare(template: string): string {
    // const original = template;
    let remaining = template;
    template = '';
    let match = remaining.match(UI.regexReplace);
    while (match != null) {
      const [_ignore, before, binding, after] = match;
      if (binding.match(/\S\s*===/)) {
        // Use BR tag since it doesn't require closing tag (won't be rendered)
        template += `${before.trimEnd()}br PUI-UNRENDERED PUI.${UI.bindingCounter++}="${binding}"`;
      } else {
        template += `${before} PUI.${UI.bindingCounter++}="${binding}" `;
      }
      remaining = after;
      match = remaining.match(UI.regexReplace);
    }
    template += remaining;

    return template;
  }
}
