(FnDecl (FnName (LowerIdent) @function))
(Primary (LowerIdent) @variable)
(Call (Primary (LowerIdent) @function.call) "(")
(Call (Primary (ForkBuiltin) @function.builtin) "(")
(Type (LowerIdent) @type)
(Type (PascalIdent) @type.parameter)
(TypePrimary (LowerIdent) @type)
(TypePrimary (PascalIdent) @type.parameter)
(TypeFnDecl (LowerIdent) @type.definition)
(TypeLetDecl (PascalIdent) @type)
(ConstDecl (LowerIdent) @variable)
(ConstDecl (LowerFieldName) @variable)
(Param (PatternIdent (LowerIdent) @variable.parameter))
(Param (PatternIdent (PascalIdent) @constructor))
(Param (LowerFieldName) @variable.parameter)
(BlockLetDecl (LowerIdent) @variable)
(BlockLetDecl (LowerFieldName) @variable)
(BlockProofConstDecl (PascalIdent) @type)
(BlockLetTail (LowerIdent) @variable)
(TopLetDecl (LowerIdent) @variable)
(TopLetDecl (LowerFieldName) @variable)
(ShapeValueSlot (LowerFieldName) @variable.other.member)
(TypeShapeSlot (LowerFieldName) @variable.other.member)
(ShapeSlot (LowerFieldName) @variable.other.member)
(Call "." (LowerIdent) @variable.other.member)
(Primary (PascalIdent) @constructor)
"module" @keyword
"import" @keyword.control.import
"capability" @keyword
"type" @keyword.type
"const" @keyword
"fn" @keyword.function
"let" @keyword
(ForkBuiltin) @function.builtin
"match" @keyword.control
(Visibility) @keyword
(TypeParamsDecl) @type.parameter
(TypeShapeRepeat) @number
(CountRepeat) @number
(PascalIdentRepeat) @number
(TypeRepeatPrefix) @number
(String) @string
(Number) @number
(Bool) @constant.builtin
"_" @keyword
"count" @keyword
"!" @operator
"(" @punctuation.bracket
")" @punctuation.bracket
"," @punctuation.delimiter
"->" @operator
"." @punctuation.delimiter
":" @punctuation.delimiter
";" @punctuation.delimiter
"=" @operator
"=>" @operator
"@" @operator
"[" @punctuation.bracket
"]" @punctuation.bracket
"{" @punctuation.bracket
"{}" @operator
"}" @punctuation.bracket
(fenced_text) @string.special
(Char) @constant
(LiteralType) @constant
