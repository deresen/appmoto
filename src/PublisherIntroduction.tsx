import introduction from "./publisher-introduction.html?raw";

export default function PublisherIntroduction() {
  // This is a repository-owned HTML fragment, also included in the initial
  // document by Vite. It never contains text submitted by app users.
  return <div dangerouslySetInnerHTML={{ __html: introduction }} />;
}
