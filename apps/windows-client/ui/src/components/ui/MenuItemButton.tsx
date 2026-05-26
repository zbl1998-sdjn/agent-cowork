import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type MenuItemRole = 'menuitem' | 'option';

export interface MenuItemButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'role'> {
  active?: boolean;
  children?: ReactNode;
  role?: MenuItemRole;
}

function menuItemClassName(className: string | undefined, active: boolean): string {
  return `ui-menu-item${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`;
}

export function MenuItemButton({
  active = false,
  children,
  className,
  role = 'menuitem',
  type = 'button',
  ...rest
}: MenuItemButtonProps) {
  return (
    <button
      type={type}
      role={role}
      aria-selected={role === 'option' ? active : undefined}
      className={menuItemClassName(className, active)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ListboxOptionButton(props: Omit<MenuItemButtonProps, 'role'>) {
  return <MenuItemButton role="option" {...props} />;
}

export default MenuItemButton;
