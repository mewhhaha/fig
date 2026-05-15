(FnDecl (FnTail (FnName (LowerIdent) @function)))
(Primary (LowerIdent) @variable)
(Call (Primary (LowerIdent) @function.call) "(")
(Primary (StaticBuiltin (LowerIdent) @function.builtin))
(TypePrimary (StaticBuiltin (LowerIdent) @function.builtin))
(TypeAtom (LowerIdent) @type.parameter)
(ConstDecl (LowerIdent) @variable)
(ImportBindingList (ImportBindingItems (LowerIdent) @variable))
(ConstDecl (FieldName) @variable)
(Param (PatternIdent (LowerIdent) @variable.parameter))
(Param (PatternIdent (PascalIdent) @constructor))
(Param (FieldName) @variable.parameter)
(ConstFnParams (LowerIdent) @variable.parameter)
(BlockLetDecl (LowerIdent) @variable)
(BlockLetDecl (FieldName) @variable)
(BlockLetTail (LowerIdent) @variable)
(TopLetDecl (LowerIdent) @variable)
(TopLetDecl (FieldName) @variable)
(TypeShapeSlot (ShapeSlotKey (LowerIdent) @variable.other.member))
(ShapeSlot (ShapeSlotKey (LowerIdent) @variable.other.member))
(Call "." (LowerIdent) @variable.other.member)
(Primary (PascalIdent) @constructor)
"import" @keyword.control.import
"capability" @keyword
"type" @keyword.type
"const" @keyword
"fn" @keyword.function
"let" @keyword
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
"do" @keyword
"else" @keyword
"if" @keyword
"zip" @keyword
"!" @operator
"%" @operator
"&&" @operator
"(" @punctuation.bracket
")" @punctuation.bracket
"*" @operator
"+" @operator
"," @punctuation.delimiter
"-" @operator
"->" @operator
"." @punctuation.delimiter
".." @operator
"..." @operator
"/" @operator
":" @punctuation.delimiter
";" @punctuation.delimiter
"<$>" @operator
"<*>" @operator
"<=" @operator
"<>" @operator
"=" @operator
"=>" @operator
">=" @operator
">>=" @operator
"@" @operator
"[" @punctuation.bracket
"\\" @operator
"]" @punctuation.bracket
"^^" @operator
"{" @punctuation.bracket
"{}" @operator
"||" @operator
"}" @punctuation.bracket
(fenced_text) @string.special
(CollectionOpen) @constant
(CollectionClose) @constant
(Char) @constant
(LiteralType) @constant
(DoBindName) @constant
