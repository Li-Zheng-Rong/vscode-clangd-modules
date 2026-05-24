// a very simple scanner, assume that source is valid c++

const Clean =
  /\/\/[^\n]*(?=\n)|\/\*[\s\S]*?\*\/|(?:u8|u|U|L)?(?:'(?:\\.|[^'\\])*'|R"([^ ()\\\n]{0,16})\([\s\S]*?\)\1"|"(?:\\.|[^"\\])*")/g;

const Parse =
  /\n *# *(?<d>(?!(?:if|ifdef|ifndef|elif|elifdef|elifndef|else|endif)(?![_\p{XID_Continue}]))[_\p{XID_Start}][_\p{XID_Continue}]*)?(?![_\p{XID_Start}])[^\n]*\n| *(?:(?<e>export +)?((?<m>module(?![_\p{XID_Continue}]))(?<mn> *[_\p{XID_Start}][_\p{XID_Continue}]*(?: *\. *[_\p{XID_Start}][_\p{XID_Continue}]*)*)(?<mp> *: *[_\p{XID_Start}][_\p{XID_Continue}]*(?: *\. *[_\p{XID_Start}][_\p{XID_Continue}]*)*)?|(?<i>import(?![_\p{XID_Continue}]))(?:(?<in> *[_\p{XID_Start}][_\p{XID_Continue}]*(?: *\. *[_\p{XID_Start}][_\p{XID_Continue}]*)*)|(?<ip> *: *[_\p{XID_Start}][_\p{XID_Continue}]*(?: *\. *[_\p{XID_Start}][_\p{XID_Continue}]*)*)))|module(?![_\p{XID_Continue}])(?! *: *private(?![_\p{XID_Continue}])))[^#;]*;|[ \n]/uy;

export type ModuleDirective = {
  kind: "module-declaration" | "import-declaration";
  name: string;
  partition: string;
  export: boolean;
};

export function scanCxxModuleDirectives(text: string): ModuleDirective[] {
  text = "\n" + text + "\n";
  text = text.replace(/\r\n|\r/g, "\n");
  text = text.replace(/[\t\v\f]/g, " ");
  text = text.replace(/\\ *\n/g, "");
  text = text.replace(Clean, " ");

  let modules: ModuleDirective[] = [];
  let position = 0;

  while (true) {
    Parse.lastIndex = position;
    const match = Parse.exec(text);
    if (!match) break;
    position = Parse.lastIndex;
    const exported = match.groups?.e !== undefined;

    if (match.groups?.m !== undefined) {
      modules.push({
        kind: "module-declaration",
        name: match.groups?.mn?.replace(/ /g, "") ?? "",
        partition: match.groups?.mp?.replace(/ /g, "") ?? "",
        export: exported,
      });
    } else if (match.groups?.i !== undefined) {
      modules.push({
        kind: "import-declaration",
        name: match.groups?.in?.replace(/ /g, "") ?? "",
        partition: match.groups?.ip?.replace(/ /g, "") ?? "",
        export: exported,
      });
    } else if ((match.groups?.d ?? "") === "include" && modules.length > 0)
      break;
  }

  return modules;
}
