import { FC, ReactNode } from "react";

const Layout: FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <main className="bg-black-3 pt-[30px] px-12 pb-14 h-screen overflow-hidden">
      {children}
    </main>
  );
};

export default Layout;
