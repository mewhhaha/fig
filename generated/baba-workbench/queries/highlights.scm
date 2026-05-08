(FnDecl (FnTail (FnName (LowerIdent) @function)))
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
(ConstDecl (FieldName) @variable)
(Param (PatternIdent (LowerIdent) @variable.parameter))
(Param (PatternIdent (PascalIdent) @constructor))
(Param (FieldName) @variable.parameter)
(BlockLetDecl (LowerIdent) @variable)
(BlockLetDecl (FieldName) @variable)
(BlockProofConstDecl (PascalIdent) @type)
(BlockLetTail (LowerIdent) @variable)
(TopLetDecl (LowerIdent) @variable)
(TopLetDecl (FieldName) @variable)
(ShapeValueSlot (FieldName) @variable.other.member)
(TypeShapeSlot (FieldName) @variable.other.member)
(ShapeSlot (FieldName) @variable.other.member)
(Call "." (LowerIdent) @variable.other.member)
(Primary (PascalIdent) @constructor)
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
(Comment) @comment
(Placeholder) @operator
"_" @keyword
"for" @keyword
"in" @keyword
"static" @keyword
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
"\\" @operator
"]" @punctuation.bracket
"{" @punctuation.bracket
"{}" @operator
"}" @punctuation.bracket
(fenced_text) @string.special
(Char) @constant
(LiteralType) @constant
